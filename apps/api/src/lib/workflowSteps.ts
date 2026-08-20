import { eq, and, inArray } from "drizzle-orm";
import { db, properties, propertyParties, workflows, workflowSteps, amlVerifications, documentPackages, documents } from "@aee/db";

const AML_TERMINAL_OK = ["Complete"];
const AML_NEEDS_REVIEW = ["Review Required", "Failed"];

function summariseAmlStatuses(statuses: string[]): string {
  if (statuses.length === 0) return "Not Started";
  if (statuses.some((s) => AML_NEEDS_REVIEW.includes(s))) return "Review Required";
  if (statuses.every((s) => AML_TERMINAL_OK.includes(s))) return "Complete";
  return "In Progress";
}

interface StepUpdate {
  status: string;
  blockedReason: string | null;
  completedAt: Date | null;
}

/**
 * WorkflowStep orchestration (ARCHITECTURE.md §10 Phase 3): recomputes the
 * Ready to List workflow's step statuses from live state (seller AML
 * verifications, document package) rather than leaving them static once
 * created. Called after anything that changes that state — ready-to-list,
 * an AML request, a seller being added or removed — so GET /workspace stays
 * a pure read instead of recomputing (and writing) on every fetch.
 */
export async function refreshReadyToListSteps(propertyId: number): Promise<void> {
  const [workflow] = await db
    .select()
    .from(workflows)
    .where(and(eq(workflows.propertyId, propertyId), eq(workflows.workflowType, "ReadyToList")));
  if (!workflow) return;

  const links = await db.select().from(propertyParties).where(eq(propertyParties.propertyId, propertyId));
  const sellerPartyIds = links.filter((l) => l.role === "Seller").map((l) => l.partyId);

  const verifications = sellerPartyIds.length
    ? await db
        .select()
        .from(amlVerifications)
        .where(and(eq(amlVerifications.propertyId, propertyId), inArray(amlVerifications.partyId, sellerPartyIds)))
    : [];

  const amlSummary = summariseAmlStatuses(verifications.map((v) => v.status));

  const [docPackage] = await db
    .select()
    .from(documentPackages)
    .where(and(eq(documentPackages.propertyId, propertyId), eq(documentPackages.purpose, "ReadyToList")));

  // Phase 5: AgencyAgreement tracks its own document within the package
  // (generated → sent → signed) separately from RequiredDocuments, which
  // tracks the package as a whole — see the comment on each StepUpdate below.
  const packageDocuments = docPackage ? await db.select().from(documents).where(eq(documents.packageId, docPackage.id)) : [];
  const agencyAgreementDoc = packageDocuments.find((d) => d.documentType === "AgencyAgreement");

  const steps = await db.select().from(workflowSteps).where(eq(workflowSteps.workflowId, workflow.id));
  const stepByKey = new Map(steps.map((s) => [s.stepKey, s]));

  let verifySellers: StepUpdate;
  if (sellerPartyIds.length === 0) {
    verifySellers = { status: "Blocked", blockedReason: "No sellers captured yet.", completedAt: null };
  } else if (amlSummary === "Review Required") {
    verifySellers = {
      status: "Blocked",
      blockedReason: "One or more seller AML verifications need review.",
      completedAt: null,
    };
  } else if (amlSummary === "Complete") {
    verifySellers = { status: "Complete", blockedReason: null, completedAt: new Date() };
  } else {
    verifySellers = { status: "InProgress", blockedReason: null, completedAt: null };
  }

  // AgencyAgreement (Phase 5): tracks the AgencyAgreement document
  // specifically through generate → send → sign, not the package as a
  // whole — a property can have its required disclosures generated while
  // the agency agreement itself is still waiting on commission terms.
  let agencyAgreement: StepUpdate;
  if (verifySellers.status !== "Complete") {
    agencyAgreement = { status: "Blocked", blockedReason: "Waiting on seller AML verification.", completedAt: null };
  } else if (!agencyAgreementDoc) {
    agencyAgreement = { status: "Blocked", blockedReason: "Documents not yet determined.", completedAt: null };
  } else if (agencyAgreementDoc.status === "Signed") {
    agencyAgreement = { status: "Complete", blockedReason: null, completedAt: new Date() };
  } else if (agencyAgreementDoc.status === "Generated" && docPackage?.status === "Sent") {
    agencyAgreement = { status: "InProgress", blockedReason: "Sent for signature — awaiting signing.", completedAt: null };
  } else if (agencyAgreementDoc.status === "Generated") {
    agencyAgreement = { status: "Ready", blockedReason: null, completedAt: null };
  } else {
    agencyAgreement = {
      status: "Blocked",
      blockedReason: "Agency agreement terms (commission) not yet captured.",
      completedAt: null,
    };
  }

  // RequiredDocuments (Phase 5): tracks the package as a whole. Complete
  // only once every document in it is actually signed — "Ready" (generated
  // but not yet sent) and "Sent" (awaiting signatures) are both still
  // in-progress, not done.
  let requiredDocuments: StepUpdate;
  if (!docPackage) {
    requiredDocuments = { status: "Blocked", blockedReason: "Documents not yet determined.", completedAt: null };
  } else if (docPackage.status === "Completed") {
    requiredDocuments = { status: "Complete", blockedReason: null, completedAt: new Date() };
  } else if (docPackage.status === "Sent") {
    requiredDocuments = { status: "InProgress", blockedReason: "Awaiting signatures.", completedAt: null };
  } else if (docPackage.status === "Ready") {
    requiredDocuments = {
      status: "InProgress",
      blockedReason: "Documents generated — ready to send for signature.",
      completedAt: null,
    };
  } else {
    requiredDocuments = { status: "InProgress", blockedReason: "Documents being generated.", completedAt: null };
  }

  const updates: Array<[string, StepUpdate]> = [
    ["VerifySellers", verifySellers],
    ["AgencyAgreement", agencyAgreement],
    ["RequiredDocuments", requiredDocuments],
  ];

  for (const [key, update] of updates) {
    const step = stepByKey.get(key);
    if (!step) continue;
    await db.update(workflowSteps).set(update).where(eq(workflowSteps.id, step.id));
  }

  // Keep the property's denormalised AML summary in sync — schema comment
  // on Property.amlStatusSummary: "source of truth remains the linked
  // AMLVerification rows", this is the read-side projection of that.
  await db
    .update(properties)
    .set({ amlStatusSummary: amlSummary, updatedAt: new Date() })
    .where(eq(properties.id, propertyId));
}
