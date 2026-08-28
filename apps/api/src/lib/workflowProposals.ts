// AI Governance Stage G8 (Build Instructions Part 9). Ordinary, non-AI-specific
// domain functions over workflowChangeProposals (packages/db/src/schema/workflow.ts).
// The AI Action Registry's WORKFLOW_CHANGE_PROPOSE / WORKFLOW_VERSION_ACTIVATE
// actions call these; a future manual "propose a workflow change" UI feature
// would call the same functions. Neither function ever touches the live
// workflows/workflowSteps tables -- an ACTIVE proposal here is a durable human
// decision record, not (yet) something that rewrites lib/workflowSteps.ts's
// live step engine. That propagation step is deliberately deferred (Build
// Instructions Part 30: no automatic workflow optimisation this stage) and is
// documented as technical debt in the Stage G completion report.
import { db, workflowChangeProposals } from "@aee/db";
import { eq, and } from "drizzle-orm";

export interface ProposedStep {
  stepKey: string;
  label: string;
  sequence: number;
}

export interface ProposeWorkflowChangeInput {
  brokerageId: number;
  propertyId: number | null;
  workflowType: "ReadyToList" | "Transaction";
  proposedSteps: ProposedStep[];
  changeReason: string;
  createdBy: number | null;
  createdSource: "human" | "ai";
  proposedByAi: boolean;
}

export async function proposeWorkflowChange(input: ProposeWorkflowChangeInput) {
  const [row] = await db
    .insert(workflowChangeProposals)
    .values({
      brokerageId: input.brokerageId,
      propertyId: input.propertyId,
      workflowType: input.workflowType,
      proposedSteps: input.proposedSteps,
      changeReason: input.changeReason,
      proposedByAi: input.proposedByAi,
      createdBy: input.createdBy,
      createdSource: input.createdSource,
      status: "PROPOSED",
    })
    .returning();
  return row;
}

// Only an authorised human (Brokerage Administrator, enforced by the action's
// allowedRoles in the registry, not here) may call this, and only through the
// approval-gated Execution Gateway -- never directly from AI code. Moves
// PROPOSED -> ACTIVE and supersedes whatever was previously ACTIVE for the
// same workflowType/brokerage, satisfying Part 9's ABSOLUTE RULE: AI must
// never silently modify an ACTIVE workflow; changes always create a new
// version, and only a human activates one.
export async function activateWorkflowChangeProposal(
  proposalId: number,
  brokerageId: number,
  activatedByUserId: number,
): Promise<typeof workflowChangeProposals.$inferSelect> {
  const [proposal] = await db
    .select()
    .from(workflowChangeProposals)
    .where(eq(workflowChangeProposals.id, proposalId));
  if (!proposal || proposal.brokerageId !== brokerageId) {
    throw new Error("Workflow change proposal not found in this brokerage.");
  }
  if (proposal.status !== "PROPOSED" && proposal.status !== "APPROVED") {
    throw new Error(`Cannot activate a proposal in status ${proposal.status}.`);
  }

  await db
    .update(workflowChangeProposals)
    .set({ status: "SUPERSEDED" })
    .where(
      and(
        eq(workflowChangeProposals.brokerageId, brokerageId),
        eq(workflowChangeProposals.workflowType, proposal.workflowType),
        eq(workflowChangeProposals.status, "ACTIVE"),
      ),
    );

  const [activated] = await db
    .update(workflowChangeProposals)
    .set({
      status: "ACTIVE",
      approvedBy: activatedByUserId,
      approvedAt: new Date(),
      activatedAt: new Date(),
    })
    .where(eq(workflowChangeProposals.id, proposalId))
    .returning();
  return activated;
}
