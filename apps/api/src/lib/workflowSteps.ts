import { eq, and, inArray } from "drizzle-orm";
import {
  db,
  properties,
  propertyParties,
  workflows,
  workflowSteps,
  amlVerifications,
  documentPackages,
  documents,
  transactions,
  type Transaction,
} from "@aee/db";
import { logAudit } from "./audit.js";

const AML_TERMINAL_OK = ["Complete"];
const AML_NEEDS_REVIEW = ["Review Required", "Failed"];

/**
 * Exported (Part B Stage 4) so apps/api/src/lib/exceptions/rules/
 * dataConsistency.ts's DC02_AML_STATUS_SUMMARY_DRIFT rule can recompute
 * "what properties.amlStatusSummary should currently be" using the exact
 * same derivation refreshReadyToListSteps uses to WRITE it — one function,
 * not two, so the detection rule's notion of "correct" can never itself
 * drift from what this module actually computes (same discipline
 * engine.ts/model.ts already apply between the event-driven and
 * time-driven dispatch paths).
 */
export function summariseAmlStatuses(statuses: string[]): string {
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
 * Part B Stage 4 remediation (open item: "a metric for how often the
 * refreshReadyToListSteps .catch() branches actually fire" — Stage 2's
 * Finding 4). Every `.catch((err) => console.error("refreshReadyToListSteps
 * failed", err))` call site in lib/aml.ts / lib/documents.ts now calls this
 * instead: keeps the exact same console.error visibility (nothing
 * regresses for anyone watching logs today) and ALSO writes a queryable
 * auditLogs row (action: "ready_to_list_steps_refresh_failed") so "how
 * often does this actually happen" is a real SQL count rather than a
 * log-grep guess — see routes/exceptions.ts's GET /exceptions/ops/health,
 * which now reports this count. Deliberately reuses auditLogs rather than
 * adding a new table or a new canonical domain event: this is an
 * operational diagnostic, not a business fact any other consumer needs to
 * react to (logAudit is itself already internally resilient — see
 * lib/audit.ts — so this can never be what breaks the caller's own
 * best-effort catch).
 */
export async function logRefreshReadyToListStepsFailure(propertyId: number, err: unknown): Promise<void> {
  console.error("refreshReadyToListSteps failed", err);
  await logAudit({
    action: "ready_to_list_steps_refresh_failed",
    recordType: "property",
    recordId: String(propertyId),
    propertyId,
    updatedValue: err instanceof Error ? err.message : String(err),
  });
}

/**
 * Part B Stage 2 remediation: lets refreshTransactionSteps run inside the
 * same db.transaction() as the canonical write that triggered it (see
 * completeSettlement/closeTransaction in lib/transactions.ts), instead of
 * always opening its own implicit statements against the module-level
 * `db`. Every existing caller that doesn't pass a second argument is
 * unaffected -- it still defaults to `db` and behaves exactly as before.
 */
type TxClient = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

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

// Part B Stage 4: the three Transaction workflow step keys, exported so
// DC01_TRANSACTION_PROJECTION_DRIFT (rules/dataConsistency.ts) can iterate
// them without re-declaring the literal list a second place it could drift
// out of sync with computeTransactionStepUpdates below.
export const TRANSACTION_STEP_KEYS = ["ContractSigning", "Settlement", "Payout"] as const;
export type TransactionStepKey = (typeof TRANSACTION_STEP_KEYS)[number];

/**
 * Part B Stage 4: the pure "what should each Transaction workflow step
 * currently be" derivation, extracted out of refreshTransactionSteps below
 * so it has exactly one implementation that both the real write path
 * (refreshTransactionSteps) AND DC01_TRANSACTION_PROJECTION_DRIFT
 * (rules/dataConsistency.ts) call — the same "one function, not two"
 * discipline engine.ts/model.ts already apply between the event-driven and
 * time-driven dispatch paths, applied here so a detection rule's notion of
 * "correct" can never itself drift from what this module actually
 * computes. No DB access, no side effects — takes a Transaction row,
 * returns what its three steps should be.
 */
export function computeTransactionStepUpdates(transaction: Transaction): Record<TransactionStepKey, StepUpdate> {
  let contractSigning: StepUpdate;
  if (transaction.contractDate) {
    contractSigning = { status: "Complete", blockedReason: null, completedAt: transaction.contractDate };
  } else {
    contractSigning = { status: "InProgress", blockedReason: null, completedAt: null };
  }

  let settlement: StepUpdate;
  if (contractSigning.status !== "Complete") {
    settlement = { status: "Blocked", blockedReason: "Awaiting contract signing.", completedAt: null };
  } else if (transaction.settlementCompletedAt) {
    settlement = { status: "Complete", blockedReason: null, completedAt: transaction.settlementCompletedAt };
  } else if (transaction.settlementDate) {
    settlement = { status: "InProgress", blockedReason: `Scheduled — awaiting completion.`, completedAt: null };
  } else {
    settlement = { status: "Ready", blockedReason: "Not yet scheduled.", completedAt: null };
  }

  let payout: StepUpdate;
  if (settlement.status !== "Complete") {
    payout = { status: "Blocked", blockedReason: "Awaiting settlement.", completedAt: null };
  } else if (transaction.agentPaidAt) {
    payout = { status: "Complete", blockedReason: null, completedAt: transaction.agentPaidAt };
  } else if (transaction.fundsReceivedCents > 0) {
    payout = { status: "InProgress", blockedReason: "Funds received — awaiting agent payout.", completedAt: null };
  } else {
    payout = { status: "Ready", blockedReason: "Awaiting funds received.", completedAt: null };
  }

  return { ContractSigning: contractSigning, Settlement: settlement, Payout: payout };
}

/**
 * WorkflowStep orchestration for the Transaction workflow (Phase 7,
 * ARCHITECTURE.md §10) — same "recompute from live state after every
 * mutation" shape as refreshReadyToListSteps above, keyed off the single
 * Transaction a property has (this build assumes one active Transaction per
 * property at a time — a prior contract falling through and a fresh offer
 * being accepted later is real future scope, not handled here, same as
 * Phase 6 documented its payer-resolution gap rather than silently
 * mishandling it).
 *
 * `executor` defaults to the module-level `db` (unchanged behaviour for
 * every pre-existing caller). Pass the `tx` handle from an in-progress
 * db.transaction() to make this refresh commit atomically with whatever
 * canonical write triggered it -- see completeSettlement/closeTransaction
 * in lib/transactions.ts for the motivating case (Part B Stage 2).
 *
 * Part B Stage 4: the per-step derivation itself now lives in
 * computeTransactionStepUpdates above — this function's job is just
 * loading the workflow/transaction/steps rows and applying whatever that
 * pure function returns.
 */
export async function refreshTransactionSteps(propertyId: number, executor: TxClient = db): Promise<void> {
  const [workflow] = await executor
    .select()
    .from(workflows)
    .where(and(eq(workflows.propertyId, propertyId), eq(workflows.workflowType, "Transaction")));
  if (!workflow) return;

  const [transaction] = await executor.select().from(transactions).where(eq(transactions.propertyId, propertyId));
  if (!transaction) return;

  const steps = await executor.select().from(workflowSteps).where(eq(workflowSteps.workflowId, workflow.id));
  const stepByKey = new Map(steps.map((s) => [s.stepKey, s]));

  const computed = computeTransactionStepUpdates(transaction);
  for (const stepKey of TRANSACTION_STEP_KEYS) {
    const step = stepByKey.get(stepKey);
    if (!step) continue;
    await executor.update(workflowSteps).set(computed[stepKey]).where(eq(workflowSteps.id, step.id));
  }
}
