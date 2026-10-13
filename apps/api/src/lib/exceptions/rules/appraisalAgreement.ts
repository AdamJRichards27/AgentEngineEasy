// Agent Engine 2.0 — Exception & Risk Engine (Priority 4).
// Category A — Appraisal & Agreement (Build Instructions §10.A, rules 1-5;
// #5 is combined into amlCtf.ts's E05_22_24_SELLER_AML_INCOMPLETE — see that
// rule's own comment). #1 is deferred: the merged appraisals/documents
// schema (packages/db/src/schema/appraisal.ts, documents.ts) has no field
// distinguishing an appraisal that has stalled unactioned toward an agency
// agreement from one still legitimately in progress — no SLA/target date,
// no follow-up-due timestamp on either table. Implementing it would mean
// inventing a threshold the domain model does not evidence (Build
// Instructions §10: "record exact missing dependency rather than
// approximating"), so it is left for a future build once that field exists.

import { and, eq, inArray, ne } from "drizzle-orm";
import { db, properties, propertyParties, documents, documentPackages, signatureRequests } from "@aee/db";
import type { RiskRule } from "../registry.js";
import type { RiskFinding } from "../types.js";
import { dedupKey, escalatesAtFor, resolveDefaultOwner, severityForDeadline } from "./shared.js";

// Seller or an authorised Power of Attorney is who can validly execute an
// Agency Agreement on the vendor's side — Solicitor/Buyer/Other roles don't
// count as "the owner or authorised party" this rule is checking for.
const OWNER_ROLES = ["Seller", "PowerOfAttorney"] as const;

const A2_MISSING_AGREEMENT_OWNER: RiskRule = {
  ruleId: "A02_AGENCY_AGREEMENT_MISSING_OWNER",
  version: 1,
  category: "APPRAISAL_AGREEMENT",
  name: "Agency agreement missing a required owner or authorised party",
  description: "A property has a generated or signed Agency Agreement document but no Seller or Power of Attorney recorded against it — the agreement cannot be validly executed without one. Draft-status documents are excluded, since a template can legitimately exist before any party is entered.",
  triggerEventTypes: ["AGENCY_AGREEMENT_SENT", "AGENCY_AGREEMENT_SIGNED"],
  async scanBrokerage(brokerageId, now) {
    const rows = await db
      .select({ document: documents, property: properties })
      .from(documents)
      .innerJoin(properties, eq(documents.propertyId, properties.id))
      .where(and(eq(properties.brokerageId, brokerageId), eq(documents.documentType, "AgencyAgreement"), ne(documents.status, "Draft")));
    if (rows.length === 0) return [];

    const propertyIds = [...new Set(rows.map((r) => r.property.id))];
    const ownerLinks = await db
      .select()
      .from(propertyParties)
      .where(and(inArray(propertyParties.propertyId, propertyIds), inArray(propertyParties.role, [...OWNER_ROLES])));
    const propertiesWithOwner = new Set(ownerLinks.map((l) => l.propertyId));

    const findings: RiskFinding[] = [];
    const seen = new Set<number>();
    for (const { document, property } of rows) {
      if (seen.has(property.id) || propertiesWithOwner.has(property.id)) continue;
      seen.add(property.id);
      const owner = resolveDefaultOwner(property, false);
      findings.push({
        ruleId: A2_MISSING_AGREEMENT_OWNER.ruleId,
        ruleVersion: A2_MISSING_AGREEMENT_OWNER.version,
        category: "APPRAISAL_AGREEMENT",
        severity: "AT_RISK",
        title: "Agency agreement missing a registered owner or authorised party",
        problemDescription: `This property has an Agency Agreement document (${document.status}) but no Seller or authorised Power of Attorney is recorded against the property.`,
        businessImpact: "An Agency Agreement without a recorded owner or authorised signatory cannot be validly executed.",
        detectedCause: "documents.documentType = AgencyAgreement with status != Draft, and no propertyParties row with role Seller or PowerOfAttorney.",
        ...owner,
        propertyId: property.id,
        transactionId: null,
        dueAt: null,
        escalatesAt: null,
        recommendedAction: "Record the seller (or authorised Power of Attorney) against this property before the agreement proceeds.",
        resolutionRequirements: "A propertyParties row with role Seller or PowerOfAttorney is recorded for this property.",
        dismissible: false,
        sourceRecordType: "property",
        sourceRecordId: String(property.id),
        dedupKey: dedupKey(A2_MISSING_AGREEMENT_OWNER.ruleId, brokerageId, property.id),
        recurrenceMode: "REOPEN",
        requiresFinancialEntitlement: false,
      });
    }
    return findings;
  },
};

const A3_AGREEMENT_SIGNATURE_OVERDUE: RiskRule = {
  ruleId: "A03_AGENCY_AGREEMENT_SIGNATURE_OVERDUE",
  version: 1,
  category: "APPRAISAL_AGREEMENT",
  name: "Agency agreement sent but not signed within the expected period",
  description: "A signature request for the Ready to List package (which carries the Agency Agreement) was sent and has not completed within the expected turnaround.",
  triggerEventTypes: ["AGENCY_AGREEMENT_SENT"],
  async scanBrokerage(brokerageId, now) {
    const rows = await db
      .select({ request: signatureRequests, property: properties })
      .from(signatureRequests)
      .innerJoin(documentPackages, eq(signatureRequests.packageId, documentPackages.id))
      .innerJoin(properties, eq(documentPackages.propertyId, properties.id))
      .where(and(eq(properties.brokerageId, brokerageId), eq(documentPackages.purpose, "ReadyToList"), eq(signatureRequests.status, "Sent")));

    const findings: RiskFinding[] = [];
    for (const { request, property } of rows) {
      if (!request.sentAt) continue;
      const dueDate = new Date(request.sentAt.getTime() + 5 * 24 * 60 * 60 * 1000);
      const severity = severityForDeadline(now, dueDate, 3, 10);
      if (severity === "INFORMATION") continue; // still within the normal signing turnaround
      const owner = resolveDefaultOwner(property, false);
      findings.push({
        ruleId: A3_AGREEMENT_SIGNATURE_OVERDUE.ruleId,
        ruleVersion: A3_AGREEMENT_SIGNATURE_OVERDUE.version,
        category: "APPRAISAL_AGREEMENT",
        severity,
        title: dueDate.getTime() < now.getTime() ? "Agency agreement signature overdue" : "Agency agreement signature approaching expected turnaround",
        problemDescription: `The Agency Agreement was sent for signature on ${request.sentAt.toDateString()} and has not yet completed.`,
        businessImpact: "An unsigned Agency Agreement blocks the listing from proceeding to Ready to List / Listed.",
        detectedCause: "signatureRequests.status = Sent beyond the expected signing turnaround.",
        ...owner,
        propertyId: property.id,
        transactionId: null,
        dueAt: dueDate,
        escalatesAt: escalatesAtFor(dueDate, 10),
        recommendedAction: "Follow up with the signatory(ies) to complete the Agency Agreement signature.",
        resolutionRequirements: "The signatureRequests row reaches status Completed, or is authoritatively Voided and reissued.",
        dismissible: false,
        sourceRecordType: "signature_request",
        sourceRecordId: String(request.id),
        dedupKey: dedupKey(A3_AGREEMENT_SIGNATURE_OVERDUE.ruleId, brokerageId, request.id),
        recurrenceMode: "REOPEN",
        requiresFinancialEntitlement: false,
        metadata: { signatureRequestId: request.id, dueDate: dueDate.toISOString() },
      });
    }
    return findings;
  },
};

const A4_SIGNED_AGREEMENT_LISTING_INFO_MISSING: RiskRule = {
  ruleId: "A04_SIGNED_AGREEMENT_MISSING_LISTING_INFO",
  version: 1,
  category: "APPRAISAL_AGREEMENT",
  stageRange: ["Ready to List"],
  name: "Signed agreement missing required listing information",
  description:
    "The Agency Agreement is signed and the property is at Ready to List, but suburb, state, or postcode is still missing — required before the listing can safely go live (state \"drives document rules\", per property.ts's own column comment). Scoped to Ready to List only; listing.ts's B07 covers the same completeness check once the property has actually gone Listed, so the two never describe the same lifecycle moment.",
  triggerEventTypes: ["AGENCY_AGREEMENT_SIGNED"],
  async scanBrokerage(brokerageId, now) {
    const rows = await db
      .select({ document: documents, property: properties })
      .from(documents)
      .innerJoin(properties, eq(documents.propertyId, properties.id))
      .where(
        and(
          eq(properties.brokerageId, brokerageId),
          eq(documents.documentType, "AgencyAgreement"),
          eq(documents.status, "Signed"),
          eq(properties.workflowStage, "Ready to List"),
        ),
      );

    const findings: RiskFinding[] = [];
    const seen = new Set<number>();
    for (const { property } of rows) {
      if (seen.has(property.id)) continue;
      const missing: string[] = [];
      if (!property.suburb) missing.push("suburb");
      if (!property.state) missing.push("state");
      if (!property.postcode) missing.push("postcode");
      if (missing.length === 0) continue;
      seen.add(property.id);
      const owner = resolveDefaultOwner(property, false);
      findings.push({
        ruleId: A4_SIGNED_AGREEMENT_LISTING_INFO_MISSING.ruleId,
        ruleVersion: A4_SIGNED_AGREEMENT_LISTING_INFO_MISSING.version,
        category: "APPRAISAL_AGREEMENT",
        severity: "ATTENTION",
        title: "Required listing information missing after agreement signed",
        problemDescription: `The Agency Agreement is signed but this property is missing: ${missing.join(", ")}.`,
        businessImpact: "Missing address/state details block the state-specific document rules and prevent the listing safely going live.",
        detectedCause: "documents.documentType = AgencyAgreement, status = Signed, and one or more of properties.suburb/state/postcode is null.",
        ...owner,
        propertyId: property.id,
        transactionId: null,
        dueAt: null,
        escalatesAt: null,
        recommendedAction: "Complete the missing property details before publishing this listing.",
        resolutionRequirements: "properties.suburb, properties.state, and properties.postcode are all recorded.",
        dismissible: false,
        sourceRecordType: "property",
        sourceRecordId: String(property.id),
        dedupKey: dedupKey(A4_SIGNED_AGREEMENT_LISTING_INFO_MISSING.ruleId, brokerageId, property.id),
        recurrenceMode: "REOPEN",
        requiresFinancialEntitlement: false,
        metadata: { missingFields: missing.join(",") },
      });
    }
    return findings;
  },
};

export const APPRAISAL_AGREEMENT_RULES: RiskRule[] = [
  A2_MISSING_AGREEMENT_OWNER,
  A3_AGREEMENT_SIGNATURE_OVERDUE,
  A4_SIGNED_AGREEMENT_LISTING_INFO_MISSING,
];
