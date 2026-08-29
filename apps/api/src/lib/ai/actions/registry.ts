// AI Governance, Authority & Action Control Architecture -- Stage G2.
//
// Central AI Action Registry (Build Instructions Part 2). No AI code may
// request an operation that is not a narrow, named entry here -- there is no
// generic UPDATE_DATABASE / RUN_SQL / CALL_API / EDIT_WORKFLOW capability
// anywhere in this module, deliberately. Every action's `execute` function
// calls an ordinary, non-AI-specific domain function (lib/propertyNotes.ts,
// lib/workflowProposals.ts) -- the registry itself never touches the
// database.
//
// Only a small number of low-risk demonstration actions are registered
// (Part 24) -- proving the architecture, not building out every eventual
// capability. AgentEngineEasy has no Task/Communication service (tasks are
// folded into WorkflowStep, per ARCHITECTURE.md), so the demonstrations
// below are adapted to what actually exists: a reversible property note
// (Level 4 EXECUTE) and a workflow-change proposal/activation pair (Level 3
// PREPARE / Level 5 SYSTEM_CHANGE) -- the latter is Part 24's Example 3
// almost verbatim.
//
// Agent Engine 2.0 -- Workflow Automation Engine (Stage: Foundation): the
// automation engine (apps/api/src/lib/automation/engine.ts) proposes and
// executes actions through this SAME registry and the SAME
// proposeAIAction()/executeAIAction() pipeline every human/AI-initiated
// action already uses -- not a parallel, competing action path. It does so
// as actorType "SYSTEM", a value aiActionRequests.actorType and
// addPropertyNote's actorType parameter already anticipated before this
// change. "SYSTEM" was added to PROPERTY_NOTE_ADD's and
// WORKFLOW_VERSION_ACTIVATE's allowedActorTypes below -- and ONLY those two
// -- because they are the two actions this foundation stage's automation
// vertical slice and its approval-required-action test coverage need;
// WORKFLOW_CHANGE_PROPOSE is untouched. Every other check on both actions
// (allowedRoles, riskLevel, requiresApproval, execute()) is unchanged.
import { z } from "zod";
import type { UserRole } from "@aee/db";
import type { RiskLevel } from "../types.js";
import type { AuthorityLevel } from "../authority.js";
import { AUTHORITY_LEVELS } from "../authority.js";
import { addPropertyNote } from "../../propertyNotes.js";
import { proposeWorkflowChange, activateWorkflowChangeProposal } from "../../workflowProposals.js";
import { assertNoProtectedOperationsRegistered } from "../protectedOperations.js";

// Part 18: actor-type axis. Kept local to the action-request system (distinct
// from packages/events' broader actorType, which predates this work and also
// covers webhook/integration-originated events).
export type ActorType = "USER" | "AI" | "PIT_CREW" | "ADMIN" | "SYSTEM";

export interface ActionExecutionContext {
  brokerageId: number;
  userId: number;
  userEmail: string;
  userRole: UserRole;
  actorType: ActorType;
}

export interface AIActionDefinition<TInput = unknown> {
  actionKey: string;
  name: string;
  description: string;
  category: string;
  authorityLevel: AuthorityLevel;
  riskLevel: RiskLevel;
  // Golden Rule (Part 4): the AI must never gain greater authority than the
  // authenticated human using it. These are exactly the manual roles who
  // could perform this action themselves.
  allowedRoles: UserRole[];
  allowedActorTypes: ActorType[];
  // Central Stage-A entitlement key (apps/api/src/lib/entitlements), if this
  // action requires a paid capability. Never bypassed for AI (Part 17).
  requiredEntitlementKey?: string;
  resourceType: "property" | "workflow_change_proposal" | null;
  inputSchema: z.ZodType<TInput>;
  reversible: boolean;
  auditRequired: true;
  enabled: boolean;
  version: number;
  summarize: (input: TInput) => string;
  execute: (ctx: ActionExecutionContext, input: TInput) => Promise<unknown>;
}

const propertyNoteInput = z.object({
  propertyId: z.number().int().positive(),
  note: z.string().min(1).max(2000),
});

const workflowChangeProposeInput = z.object({
  propertyId: z.number().int().positive().nullable(),
  workflowType: z.enum(["ReadyToList", "Transaction"]),
  proposedSteps: z
    .array(z.object({ stepKey: z.string().min(1), label: z.string().min(1), sequence: z.number().int() }))
    .min(1),
  changeReason: z.string().min(1).max(2000),
});

const workflowVersionActivateInput = z.object({
  proposalId: z.number().int().positive(),
});

export const ACTION_REGISTRY: Record<string, AIActionDefinition<any>> = {
  PROPERTY_NOTE_ADD: {
    actionKey: "PROPERTY_NOTE_ADD",
    name: "Add property note",
    description: "Append a timestamped, attributed note to a property's timeline. Purely additive and reversible (the note is a normal audit_logs row).",
    category: "property",
    authorityLevel: AUTHORITY_LEVELS.EXECUTE,
    riskLevel: 0,
    allowedRoles: ["Agent", "Brokerage Administrator"],
    // "SYSTEM" added (Agent Engine 2.0 WAE foundation): this is the action
    // the AGENCY_AGREEMENT_SIGNED system template rule uses -- see
    // apps/api/src/lib/automation/templates.ts. Additive/reversible/riskLevel 0,
    // so this stays auto-execute-eligible regardless of actor type.
    allowedActorTypes: ["AI", "USER", "SYSTEM"],
    resourceType: "property",
    inputSchema: propertyNoteInput,
    reversible: true,
    auditRequired: true,
    enabled: true,
    version: 1,
    summarize: (input) => `Add a note to property #${input.propertyId}: "${input.note.slice(0, 120)}"`,
    execute: async (ctx, input) =>
      addPropertyNote({
        propertyId: input.propertyId,
        brokerageId: ctx.brokerageId,
        userId: ctx.userId,
        userEmail: ctx.userEmail,
        note: input.note,
        actorType: ctx.actorType,
      }),
  },

  WORKFLOW_CHANGE_PROPOSE: {
    actionKey: "WORKFLOW_CHANGE_PROPOSE",
    name: "Propose workflow change",
    description: "Create a new DRAFT/PROPOSED workflow version. Never alters the active workflow (Build Instructions Part 9's ABSOLUTE RULE).",
    category: "workflow",
    authorityLevel: AUTHORITY_LEVELS.PREPARE,
    riskLevel: 1,
    allowedRoles: ["Agent", "Brokerage Administrator"],
    allowedActorTypes: ["AI", "USER"],
    resourceType: "property",
    inputSchema: workflowChangeProposeInput,
    reversible: true,
    auditRequired: true,
    enabled: true,
    version: 1,
    summarize: (input) =>
      `Propose a new ${input.workflowType} workflow version (${input.proposedSteps.length} steps): ${input.changeReason}`,
    execute: async (ctx, input) =>
      proposeWorkflowChange({
        brokerageId: ctx.brokerageId,
        propertyId: input.propertyId,
        workflowType: input.workflowType,
        proposedSteps: input.proposedSteps,
        changeReason: input.changeReason,
        createdBy: ctx.userId,
        createdSource: ctx.actorType === "AI" ? "ai" : "human",
        proposedByAi: ctx.actorType === "AI",
      }),
  },

  WORKFLOW_VERSION_ACTIVATE: {
    actionKey: "WORKFLOW_VERSION_ACTIVATE",
    name: "Activate workflow version",
    description: "Activate a previously proposed workflow version, superseding whatever was active. A SYSTEM_CHANGE action: the AI may request it, but it always requires explicit Brokerage Administrator approval.",
    category: "workflow",
    authorityLevel: AUTHORITY_LEVELS.SYSTEM_CHANGE,
    riskLevel: 3,
    allowedRoles: ["Brokerage Administrator"],
    // "SYSTEM" added (Agent Engine 2.0 WAE foundation) so an automation
    // rule can propose activation -- it still always requires Brokerage
    // Administrator approval (SYSTEM_CHANGE never auto-executes, see
    // authority.ts's isAutoExecuteEligible) through the same, unmodified
    // approval endpoints. Nothing about this action's role/approval
    // requirements changed.
    allowedActorTypes: ["AI", "USER", "SYSTEM"],
    resourceType: "workflow_change_proposal",
    inputSchema: workflowVersionActivateInput,
    reversible: false,
    auditRequired: true,
    enabled: true,
    version: 1,
    summarize: (input) => `Activate workflow change proposal #${input.proposalId}, superseding the current active version.`,
    execute: async (ctx, input) => activateWorkflowChangeProposal(input.proposalId, ctx.brokerageId, ctx.userId),
  },
};

// Stage G9 startup self-check: crash the app rather than let a
// miscategorised or forbidden action reach the AI-executable registry.
// See protectedOperations.ts for the full rationale.
assertNoProtectedOperationsRegistered(Object.values(ACTION_REGISTRY));

export function getActionDefinition(actionKey: string): AIActionDefinition<any> | undefined {
  return ACTION_REGISTRY[actionKey];
}

export function listActionDefinitions(): AIActionDefinition<any>[] {
  return Object.values(ACTION_REGISTRY);
}
