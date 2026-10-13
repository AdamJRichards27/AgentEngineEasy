// Agent Engine 2.0 — Exception & Risk Engine (Priority 4).
// Category B — Listing (Build Instructions §10.B, rules 6-9). #8 (v2) is
// implemented against properties.salesMethod/priceDisplay/campaignStartDate/
// campaignEndDate — the Stage C "Listing preparation" columns (see
// property.ts's own comment on them), which the live Property Workspace
// already surfaces as a non-blocking prompt when missing. This rule doesn't
// change that UI behaviour. While the property is still being marketed
// (Listed or Under Offer) it gives the same condition a durable, tenant-
// visible record. Sold (Contract), settled (Settlement), and closed
// (Closed) properties are outside that window: an empty campaign record
// there is resolved by the scheduled sweep as NO_LONGER_APPLICABLE, and
// the historical row is kept.
// #9 remains deferred: no field anywhere in property.ts, workflow.ts, or
// commerce.ts tracks the underlying condition it describes (Build
// Instructions §10: "record exact missing dependency rather than
// approximating").

import { and, eq, inArray, ne } from "drizzle-orm";
import { db, properties, documentPackages, signatureRequests, type RiskException } from "@aee/db";
import type { RiskRule } from "../registry.js";
import type { ResolutionEvidence, RiskFinding } from "../types.js";
import { dedupKey, escalatesAtFor, resolveDefaultOwner, severityForDeadline } from "./shared.js";

const B6_LISTING_PREP_OVERDUE: RiskRule = {
  ruleId: "B06_SIGNED_AGREEMENT_LISTING_PREP_OVERDUE",
  version: 1,
  category: "LISTING",
  name: "Listing preparation overdue after agreement signed",
  description: "The Ready to List signature package completed but the property has not progressed to Listed within the expected preparation window.",
  triggerEventTypes: ["AGENCY_AGREEMENT_SIGNED"],
  async scanBrokerage(brokerageId, now) {
    const rows = await db
      .select({ request: signatureRequests, property: properties })
      .from(signatureRequests)
      .innerJoin(documentPackages, eq(signatureRequests.packageId, documentPackages.id))
      .innerJoin(properties, eq(documentPackages.propertyId, properties.id))
      .where(
        and(
          eq(properties.brokerageId, brokerageId),
          eq(documentPackages.purpose, "ReadyToList"),
          eq(signatureRequests.status, "Completed"),
          eq(properties.workflowStage, "Ready to List"),
        ),
      );

    const findings: RiskFinding[] = [];
    const seen = new Set<number>();
    for (const { request, property } of rows) {
      if (!request.completedAt || seen.has(property.id)) continue;
      const dueDate = new Date(request.completedAt.getTime() + 14 * 24 * 60 * 60 * 1000);
      const severity = severityForDeadline(now, dueDate, 7, 21);
      if (severity === "INFORMATION") continue; // still within the normal prep window
      seen.add(property.id);
      const owner = resolveDefaultOwner(property, false);
      findings.push({
        ruleId: B6_LISTING_PREP_OVERDUE.ruleId,
        ruleVersion: B6_LISTING_PREP_OVERDUE.version,
        category: "LISTING",
        severity,
        title: "Listing preparation is taking longer than expected",
        problemDescription: `The Agency Agreement signature package completed on ${request.completedAt.toDateString()} but this property has not yet gone Listed.`,
        businessImpact: "A stalled handoff between a signed agreement and a live listing delays the vendor's campaign and the brokerage's pipeline.",
        detectedCause: "signatureRequests.status = Completed for the ReadyToList package, and properties.workflowStage remains Ready to List beyond the expected preparation window.",
        ...owner,
        propertyId: property.id,
        transactionId: null,
        dueAt: dueDate,
        escalatesAt: escalatesAtFor(dueDate, 21),
        recommendedAction: "Complete outstanding listing preparation tasks and publish the listing, or record why it remains unlisted.",
        resolutionRequirements: "properties.workflowStage advances to Listed (or beyond).",
        dismissible: false,
        sourceRecordType: "property",
        sourceRecordId: String(property.id),
        dedupKey: dedupKey(B6_LISTING_PREP_OVERDUE.ruleId, brokerageId, property.id),
        recurrenceMode: "REOPEN",
        requiresFinancialEntitlement: false,
      });
    }
    return findings;
  },
};

const B7_LISTING_LIVE_INFO_MISSING: RiskRule = {
  ruleId: "B07_LISTING_LIVE_MISSING_REQUIRED_INFO",
  version: 1,
  category: "LISTING",
  name: "Listing is live with required information missing",
  description:
    "The property has progressed to Listed (or beyond) but suburb, state, or postcode is still missing. Scoped to Listed-onward; appraisalAgreement.ts's A04 covers the same completeness check at the earlier Ready to List stage, so the two never describe the same lifecycle moment.",
  triggerEventTypes: ["LISTING_LIVE"],
  async scanBrokerage(brokerageId, now) {
    const rows = await db
      .select()
      .from(properties)
      .where(and(eq(properties.brokerageId, brokerageId), ne(properties.workflowStage, "Appraisal"), ne(properties.workflowStage, "Ready to List")));

    const findings: RiskFinding[] = [];
    for (const property of rows) {
      const missing: string[] = [];
      if (!property.suburb) missing.push("suburb");
      if (!property.state) missing.push("state");
      if (!property.postcode) missing.push("postcode");
      if (missing.length === 0) continue;
      const owner = resolveDefaultOwner(property, false);
      findings.push({
        ruleId: B7_LISTING_LIVE_INFO_MISSING.ruleId,
        ruleVersion: B7_LISTING_LIVE_INFO_MISSING.version,
        category: "LISTING",
        severity: "AT_RISK",
        title: "Live listing is missing required information",
        problemDescription: `This listing is live but is missing: ${missing.join(", ")}.`,
        businessImpact: "A live listing with incomplete address details risks incorrect marketing, search, and document generation.",
        detectedCause: "properties.workflowStage is Listed or later and one or more of suburb/state/postcode is null.",
        ...owner,
        propertyId: property.id,
        transactionId: null,
        dueAt: null,
        escalatesAt: null,
        recommendedAction: "Complete the missing property details immediately.",
        resolutionRequirements: "properties.suburb, properties.state, and properties.postcode are all recorded.",
        dismissible: false,
        sourceRecordType: "property",
        sourceRecordId: String(property.id),
        dedupKey: dedupKey(B7_LISTING_LIVE_INFO_MISSING.ruleId, brokerageId, property.id),
        recurrenceMode: "REOPEN",
        requiresFinancialEntitlement: false,
        metadata: { missingFields: missing.join(",") },
      });
    }
    return findings;
  },
};

// B08 v2. Campaign / sales-method fields are pre-marketing information.
// They are an active finding only while the property is still being
// marketed. Inclusive upper bound is Under Offer: Contract is sold,
// Settlement is settled, and Closed is closed. Empty fields on those
// completed stages are historical, not an open exception. B06 and B07
// are unchanged — address completeness (B07) still applies after sale.
export const B08_RULE_ID = "B08_LISTING_LIVE_MISSING_CAMPAIGN_INFO";
export const B08_RULE_VERSION = 2;
export const B08_ACTIVE_MARKETING_STAGES = ["Listed", "Under Offer"] as const;

type CampaignFieldSource = {
  salesMethod: string | null;
  priceDisplay: string | null;
  campaignStartDate: Date | null;
  campaignEndDate: Date | null;
};

function missingCampaignFields(property: CampaignFieldSource): string[] {
  const missing: string[] = [];
  if (!property.salesMethod) missing.push("sales method");
  if (!property.priceDisplay) missing.push("price display");
  if (!property.campaignStartDate) missing.push("campaign start date");
  if (!property.campaignEndDate) missing.push("campaign end date");
  return missing;
}

/**
 * Evidence for an open B08 row that this pass did not re-detect.
 * Null keeps the engine default (RULE_CONDITION_CLEARED): the property is
 * still inside the marketing window, or the campaign fields are now
 * present, so the absence is a real clear. NO_LONGER_APPLICABLE is only
 * for a property outside that window whose pre-marketing fields are still
 * empty — the exception is preserved, not dismissed, and not described as
 * fixed.
 */
export function b08EvidenceWhenAbsent(
  property: CampaignFieldSource & { workflowStage: string },
  ruleVersion: number = B08_RULE_VERSION,
): ResolutionEvidence | null {
  const inMarketingWindow = (B08_ACTIVE_MARKETING_STAGES as readonly string[]).includes(property.workflowStage);
  if (inMarketingWindow) return null;
  if (missingCampaignFields(property).length === 0) return null;
  return {
    kind: "NO_LONGER_APPLICABLE",
    ruleId: B08_RULE_ID,
    ruleVersion,
    workflowStage: property.workflowStage,
  };
}

const B8_LISTING_MISSING_CAMPAIGN_INFO: RiskRule = {
  ruleId: B08_RULE_ID,
  version: B08_RULE_VERSION,
  category: "LISTING",
  name: "Listing is live with no campaign or sales-method information",
  description:
    "The property is in an active marketing stage (Listed or Under Offer) but salesMethod, priceDisplay, or the campaign start/end dates are still missing. Softer signal than B07 (marketing/descriptive fields, not the legal address fields required for document generation) — ATTENTION rather than AT_RISK. Once the property is sold (Contract), settled (Settlement), or closed (Closed), an empty campaign record is no longer an active exception.",
  triggerEventTypes: ["LISTING_LIVE"],
  async scanBrokerage(brokerageId, now) {
    const rows = await db
      .select()
      .from(properties)
      .where(and(eq(properties.brokerageId, brokerageId), inArray(properties.workflowStage, [...B08_ACTIVE_MARKETING_STAGES])));

    const findings: RiskFinding[] = [];
    for (const property of rows) {
      const missing = missingCampaignFields(property);
      if (missing.length === 0) continue;
      const owner = resolveDefaultOwner(property, false);
      findings.push({
        ruleId: B8_LISTING_MISSING_CAMPAIGN_INFO.ruleId,
        ruleVersion: B8_LISTING_MISSING_CAMPAIGN_INFO.version,
        category: "LISTING",
        severity: "ATTENTION",
        title: "Live listing is missing campaign or sales-method information",
        problemDescription: `This listing is live but is missing: ${missing.join(", ")}.`,
        businessImpact: "Missing campaign/sales-method details leave marketing materials and buyer-facing pages incomplete.",
        detectedCause: "properties.workflowStage is Listed or Under Offer and one or more of salesMethod/priceDisplay/campaignStartDate/campaignEndDate is null.",
        ...owner,
        propertyId: property.id,
        transactionId: null,
        dueAt: null,
        escalatesAt: null,
        recommendedAction: "Complete the missing campaign and sales-method details for this listing.",
        resolutionRequirements: "properties.salesMethod, priceDisplay, campaignStartDate, and campaignEndDate are all recorded, or the property leaves the active marketing stages (Listed, Under Offer).",
        dismissible: false,
        sourceRecordType: "property",
        sourceRecordId: String(property.id),
        dedupKey: dedupKey(B8_LISTING_MISSING_CAMPAIGN_INFO.ruleId, brokerageId, property.id),
        recurrenceMode: "REOPEN",
        requiresFinancialEntitlement: false,
        metadata: { missingFields: missing.join(",") },
      });
    }
    return findings;
  },
  async resolutionEvidenceWhenAbsent(openException: RiskException): Promise<ResolutionEvidence | null> {
    const [property] = await db
      .select({
        brokerageId: properties.brokerageId,
        workflowStage: properties.workflowStage,
        salesMethod: properties.salesMethod,
        priceDisplay: properties.priceDisplay,
        campaignStartDate: properties.campaignStartDate,
        campaignEndDate: properties.campaignEndDate,
      })
      .from(properties)
      .where(and(eq(properties.id, openException.propertyId), eq(properties.brokerageId, openException.brokerageId)));
    if (!property) return null;
    return b08EvidenceWhenAbsent(property, B8_LISTING_MISSING_CAMPAIGN_INFO.version);
  },
};

export const LISTING_RULES: RiskRule[] = [B6_LISTING_PREP_OVERDUE, B7_LISTING_LIVE_INFO_MISSING, B8_LISTING_MISSING_CAMPAIGN_INFO];
