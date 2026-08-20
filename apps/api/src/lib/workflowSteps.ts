import { eq, and, inArray } from "drizzle-orm";
import { db, properties, propertyParties, workflows, workflowSteps, amlVerifications, documentPackages } from "@aee/db";

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

  const agencyAgreement: StepUpdate =
    verifySellers.status === "Complete"
      ? { status: "Ready", blockedReason: null, completedAt: null }
      : { status: "Blocked", blockedReason: "Waiting on seller AML verification.", completedAt: null };

  const requiredDocuments: StepUpdate = docPackage
    ? {
        status: docPackage.status === "Ready" || docPackage.status === "Completed" ? "Complete" : "InProgress",
        blockedReason: null,
        completedAt: null,
      }
    : { status: "Blocked", blockedReason: "Documents not yet determined.", completedAt: null };

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
