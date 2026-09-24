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
//
// Agent Engine 2.0 -- WAE Stage 2 (Controlled Production Workflows): five
// new actions below (CREATE_INTERNAL_TASK, CREATE_REMINDER,
// ASSIGN_TASK_OWNER, RAISE_ATTENTION_ITEM, REQUEST_ACTION_APPROVAL) back the
// initial production workflow catalogue (apps/api/src/lib/automation/templates.ts).
// Every one of them is internal and reversible (Build Instructions §5):
// none sends an external email/SMS, touches money, calls a third party, or
// mutates anything outside the new automation_tasks/automation_attention_items
// tables this stage adds. Their execute() functions call ordinary domain
// functions in apps/api/src/lib/automation/{tasks,attentionItems}.ts, the
// exact same "registry never touches the database" convention as every
// other entry in this file.
//
// AE GROW Priority 6 Stage D — AI-Proposed, Human-Approved Follow-Up
// Actions: one new action, CREATE_GROW_COMMITMENT, backing Ask AE and the
// Business Coach's ability to propose a follow-up commitment against a
// contact (apps/api/src/lib/ai/orchestrator.ts). Scoped to exactly this one
// action per the Project Owner's authorisation — no broader action
// catalogue. Authority EXECUTE + riskLevel 2 (MEDIUM) is the same
// combination REQUEST_ACTION_APPROVAL already uses to guarantee human
// approval by construction of isAutoExecuteEligible() (authority.ts), never
// a special case added for this action. allowedActorTypes is ["AI"] only —
// this action is proposed exclusively by the orchestrator's internal call
// into proposeAIAction() with actorType "AI"; it is never reachable through
// routes/ai-actions.ts's public propose endpoint, which hardcodes
// actorType "USER" and would therefore always be rejected by the Policy
// Engine's ACTOR_TYPE_FORBIDDEN check for this action. execute() calls a
// new, ordinary domain function (lib/growCommitmentActions.ts) that mirrors
// routes/contacts.ts's existing manual commitment-creation validation -- no
// new database table, no new entitlement.
import { z } from "zod";
import { USER_ROLES, type UserRole } from "@aee/db";
import type { RiskLevel } from "../types.js";
import type { AuthorityLevel } from "../authority.js";
import { AUTHORITY_LEVELS } from "../authority.js";
import { addPropertyNote } from "../../propertyNotes.js";
import { proposeWorkflowChange, activateWorkflowChangeProposal } from "../../workflowProposals.js";
import { assertNoProtectedOperationsRegistered } from "../protectedOperations.js";
import { createAutomationTask, assignAutomationTaskToRole } from "../../automation/tasks.js";
import { raiseAttentionItem } from "../../automation/attentionItems.js";
import { createApprovedGrowCommitment } from "../../growCommitmentActions.js";
import { attachCommitmentToCallReviewLink, callReviewLinkSchema } from "../../growCallReviewLinks.js";
import {
  AUTOMATION_TASK_KEYS,
  AUTOMATION_ATTENTION_REASON_CODES,
  PROTECTED_FUTURE_ACTION_KEYS,
} from "../../automation/types.js";

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
  // Set by the execution gateway so a call-review proposal can stamp
  // grow_call_review_links.commitment_id. Absent only for callers that
  // invoke execute() outside the gateway.
  actionRequestId?: number;
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
  resourceType: "property" | "workflow_change_proposal" | "automation_task" | "automation_attention_item" | "grow_commitment" | null;
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

// ---------------------------------------------------------------------
// WAE Stage 2 — input schemas.
//
// isValidIsoDate: a plain, non-throwing validity check (no eval/Function) —
// this is how "handle missing/invalid dates safely" (Build Instructions §6)
// is enforced for CREATE_REMINDER: an invalid dueAt fails zod validation
// (evaluateAIAction's INPUT_SCHEMA_INVALID branch) and the automation
// action is cleanly BLOCKED with a clear reason, rather than throwing or
// silently coercing to `Invalid Date`.
// ---------------------------------------------------------------------

function isValidIsoDate(value: string): boolean {
  return !Number.isNaN(Date.parse(value));
}

const automationTaskKeyEnum = z.enum(AUTOMATION_TASK_KEYS);
const userRoleEnum = z.enum(USER_ROLES);

const createInternalTaskInput = z.object({
  propertyId: z.number().int().positive(),
  transactionId: z.number().int().positive().nullable().optional(),
  taskKey: automationTaskKeyEnum,
  title: z.string().min(1).max(200),
  detail: z.string().max(2000).nullable().optional(),
  assignedRole: userRoleEnum.nullable().optional(),
  dueAt: z.string().refine(isValidIsoDate, { message: "dueAt must be a valid ISO-8601 date" }).nullable().optional(),
  originatingEventId: z.string().uuid().nullable().optional(),
  originatingField: z.string().max(200).nullable().optional(),
});

const createReminderInput = createInternalTaskInput.extend({
  // A reminder is a task whose date is authoritative and required (Build
  // Instructions §6: "use authoritative transaction dates") — the one
  // required field CREATE_INTERNAL_TASK leaves optional.
  dueAt: z.string().refine(isValidIsoDate, { message: "dueAt must be a valid ISO-8601 date" }),
});

const assignTaskOwnerInput = z.object({
  propertyId: z.number().int().positive(),
  taskKey: automationTaskKeyEnum,
  assignedRole: userRoleEnum,
});

const raiseAttentionItemInput = z.object({
  propertyId: z.number().int().positive(),
  transactionId: z.number().int().positive().nullable().optional(),
  reasonCode: z.enum(AUTOMATION_ATTENTION_REASON_CODES),
  summary: z.string().min(1).max(500),
  detail: z.record(z.unknown()).nullable().optional(),
  originatingEventId: z.string().uuid().nullable().optional(),
});

const requestActionApprovalInput = z.object({
  propertyId: z.number().int().positive(),
  transactionId: z.number().int().positive().nullable().optional(),
  protectedActionKey: z.enum(PROTECTED_FUTURE_ACTION_KEYS),
  reason: z.string().min(1).max(1000),
});

// ---------------------------------------------------------------------
// AE GROW Priority 6 Stage D — input schema.
// ---------------------------------------------------------------------

const createGrowCommitmentInput = z.object({
  partyId: z.number().int().positive(),
  description: z.string().min(1).max(2000),
  dueAt: z.string().refine(isValidIsoDate, { message: "dueAt must be a valid ISO-8601 date" }),
  propertyId: z.number().int().positive().nullable().optional(),
  opportunityId: z.number().int().positive().nullable().optional(),
  // Why AE is proposing this, and what it is grounded in — carried through
  // to the human-readable summary and the audit trail, never used to
  // control execution (Part 20: an AI-authored string is inert data, never
  // an instruction). No appraisalId field: growCommitments (packages/db/src/
  // schema/contacts.ts) has no such column (see docs/AE_GROW_PRIORITY_6_
  // STAGE_D_APPROVED_ACTIONS_REPORT.md §2.2) — an appraisal is referenced
  // only as free text inside `reason`/`evidenceSummary` when relevant, never
  // as a first-class relational id.
  reason: z.string().min(1).max(1000),
  evidenceSummary: z.string().max(1000).nullable().optional(),
  // Provenance back to the AI interaction/recommendation that produced this
  // proposal (Response Contract requirement) — purely informational,
  // never read by execute() itself.
  originatingInteractionId: z.number().int().positive().nullable().optional(),
  // A deterministic key the orchestrator derives from the source Grow Today
  // item + due date, carried as the action request's resourceId (not part
  // of the growCommitments row itself) so a repeat Ask AE/Coach call for
  // the same underlying item does not create a second, duplicate
  // proposal while one is already pending — see actionRequests.ts's
  // findOpenActionRequestByResource().
  dedupeKey: z.string().min(1).max(200).nullable().optional(),
  // E-8: structured call-review source, stored on the approved payload.
  // The join itself is grow_call_review_links (foreign keys). Absent for
  // Ask AE / Coach proposals, which are not call-review items.
  callReview: callReviewLinkSchema.nullable().optional(),
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

  // ---------------------------------------------------------------------
  // WAE Stage 2 — Controlled Production Workflows.
  // ---------------------------------------------------------------------

  CREATE_INTERNAL_TASK: {
    actionKey: "CREATE_INTERNAL_TASK",
    name: "Create internal task",
    description:
      "Create an internal, human-actionable follow-up task for a property/transaction from a closed vocabulary of task keys. Purely additive and reversible — completing or cancelling a task never deletes its historical record.",
    category: "automation",
    authorityLevel: AUTHORITY_LEVELS.EXECUTE,
    riskLevel: 0,
    allowedRoles: ["Agent", "Brokerage Administrator", "Pit Crew"],
    allowedActorTypes: ["AI", "USER", "SYSTEM"],
    resourceType: "automation_task",
    inputSchema: createInternalTaskInput,
    reversible: true,
    auditRequired: true,
    enabled: true,
    version: 1,
    summarize: (input) => `Create internal task "${input.title}" for property #${input.propertyId} (${input.taskKey})`,
    execute: async (ctx, input) =>
      createAutomationTask({
        brokerageId: ctx.brokerageId,
        propertyId: input.propertyId,
        transactionId: input.transactionId ?? null,
        taskKey: input.taskKey,
        kind: "TASK",
        title: input.title,
        detail: input.detail ?? null,
        assignedRole: input.assignedRole ?? null,
        dueAt: input.dueAt ? new Date(input.dueAt) : null,
        originatingEventId: input.originatingEventId ?? null,
        originatingField: input.originatingField ?? null,
      }),
  },

  CREATE_REMINDER: {
    actionKey: "CREATE_REMINDER",
    name: "Create reminder",
    description:
      "Create a date-based internal reminder tied to an authoritative transaction date from a closed vocabulary of task keys. Purely additive and reversible. A material date change supersedes the prior reminder rather than overwriting it.",
    category: "automation",
    authorityLevel: AUTHORITY_LEVELS.EXECUTE,
    riskLevel: 0,
    allowedRoles: ["Agent", "Brokerage Administrator", "Pit Crew"],
    allowedActorTypes: ["AI", "USER", "SYSTEM"],
    resourceType: "automation_task",
    inputSchema: createReminderInput,
    reversible: true,
    auditRequired: true,
    enabled: true,
    version: 1,
    summarize: (input) => `Create reminder "${input.title}" due ${input.dueAt} for property #${input.propertyId} (${input.taskKey})`,
    execute: async (ctx, input) =>
      createAutomationTask({
        brokerageId: ctx.brokerageId,
        propertyId: input.propertyId,
        transactionId: input.transactionId ?? null,
        taskKey: input.taskKey,
        kind: "REMINDER",
        title: input.title,
        detail: input.detail ?? null,
        assignedRole: input.assignedRole ?? null,
        dueAt: new Date(input.dueAt),
        originatingEventId: input.originatingEventId ?? null,
        originatingField: input.originatingField ?? null,
      }),
  },

  ASSIGN_TASK_OWNER: {
    actionKey: "ASSIGN_TASK_OWNER",
    name: "Assign task to an internal role",
    description:
      "Assign or re-assign the current active internal automation task for a property to an authorised internal role. Reversible — a task can be re-assigned again at any time.",
    category: "automation",
    authorityLevel: AUTHORITY_LEVELS.EXECUTE,
    riskLevel: 0,
    allowedRoles: ["Agent", "Brokerage Administrator", "Pit Crew"],
    allowedActorTypes: ["AI", "USER", "SYSTEM"],
    resourceType: "automation_task",
    inputSchema: assignTaskOwnerInput,
    reversible: true,
    auditRequired: true,
    enabled: true,
    version: 1,
    summarize: (input) => `Assign task ${input.taskKey} on property #${input.propertyId} to ${input.assignedRole}`,
    execute: async (ctx, input) =>
      assignAutomationTaskToRole({
        brokerageId: ctx.brokerageId,
        propertyId: input.propertyId,
        taskKey: input.taskKey,
        assignedRole: input.assignedRole,
      }),
  },

  RAISE_ATTENTION_ITEM: {
    actionKey: "RAISE_ATTENTION_ITEM",
    name: "Raise attention item",
    description:
      "Raise an internal exception/attention item when a workflow cannot safely proceed. The smallest compatible interface onto the future Exception & Risk Engine — see docs/stage-wf/WF3_STAGE2_CONTROLLED_WORKFLOWS.md.",
    category: "automation",
    authorityLevel: AUTHORITY_LEVELS.EXECUTE,
    riskLevel: 0,
    allowedRoles: ["Agent", "Brokerage Administrator", "Pit Crew"],
    allowedActorTypes: ["AI", "USER", "SYSTEM"],
    resourceType: "automation_attention_item",
    inputSchema: raiseAttentionItemInput,
    reversible: true,
    auditRequired: true,
    enabled: true,
    version: 1,
    summarize: (input) => `Raise attention item (${input.reasonCode}) for property #${input.propertyId}: ${input.summary.slice(0, 120)}`,
    execute: async (ctx, input) =>
      raiseAttentionItem({
        brokerageId: ctx.brokerageId,
        propertyId: input.propertyId,
        transactionId: input.transactionId ?? null,
        reasonCode: input.reasonCode,
        summary: input.summary,
        detail: input.detail ?? null,
        originatingEventId: input.originatingEventId ?? null,
      }),
  },

  REQUEST_ACTION_APPROVAL: {
    actionKey: "REQUEST_ACTION_APPROVAL",
    name: "Request approval for a protected future action",
    description:
      "Record a request for human approval before a protected, out-of-scope action (e.g. ordering AML verification, publishing a listing, engaging a supplier) is performed manually. This action never performs the protected action itself — Stage 2 has no executable path for any of them, by design — it only creates a durable, approval-gated record that a human reviewed and approved proceeding manually. riskLevel/authorityLevel are set so this action is never auto-execute-eligible (isAutoExecuteEligible always returns false for it) — approval is enforced by the existing AI Governance policy engine, never a boolean flag the workflow itself controls.",
    category: "automation",
    authorityLevel: AUTHORITY_LEVELS.EXECUTE,
    riskLevel: 2,
    allowedRoles: ["Agent", "Brokerage Administrator"],
    allowedActorTypes: ["AI", "USER", "SYSTEM"],
    resourceType: "automation_attention_item",
    inputSchema: requestActionApprovalInput,
    reversible: true,
    auditRequired: true,
    enabled: true,
    version: 1,
    summarize: (input) => `Request approval before "${input.protectedActionKey}" for property #${input.propertyId}: ${input.reason.slice(0, 120)}`,
    // Executes only once a human has actually approved the request through
    // the existing, unmodified approval endpoints (component 8, "execute
    // only the exact approved action"): the "exact approved action" here is
    // precisely "record that approval was granted for this protected,
    // out-of-scope action" — never the protected action itself, which this
    // codebase has no registered, executable path for.
    execute: async (ctx, input) =>
      raiseAttentionItem({
        brokerageId: ctx.brokerageId,
        propertyId: input.propertyId,
        transactionId: input.transactionId ?? null,
        reasonCode: "OTHER",
        summary: `Approval granted to proceed with ${input.protectedActionKey} (manual, outside this system): ${input.reason}`,
        detail: { protectedActionKey: input.protectedActionKey, approvedByUserId: ctx.userId },
        originatingEventId: null,
      }),
  },

  // ---------------------------------------------------------------------
  // AE GROW Priority 6 Stage D — AI-Proposed, Human-Approved Follow-Up
  // Actions.
  // ---------------------------------------------------------------------

  CREATE_GROW_COMMITMENT: {
    actionKey: "CREATE_GROW_COMMITMENT",
    name: "Create Grow commitment",
    description:
      "Create a single commitment (a recorded promise against a contact, stored as a grow_commitments row) proposed by Ask AE or the Business Coach from grounded Grow data. This is not an opportunity or appraisal due follow-up. Always requires explicit human approval — riskLevel 2 combined with authorityLevel EXECUTE means isAutoExecuteEligible() is always false for this action (authority.ts), by construction, not a special case. Nothing is created until an authorised human reviews and approves the exact proposed contact, reason, and due date.",
    category: "grow",
    authorityLevel: AUTHORITY_LEVELS.EXECUTE,
    riskLevel: 2,
    allowedRoles: ["Agent", "Brokerage Administrator", "Pit Crew"],
    // AI only — this action is never proposed by a human calling
    // routes/ai-actions.ts's generic propose endpoint directly (that route
    // hardcodes actorType "USER", which the Policy Engine's
    // ACTOR_TYPE_FORBIDDEN check would reject here). It is proposed only
    // from orchestrator.ts's internal call into proposeAIAction() with
    // actorType "AI". It can likewise never be approved or executed by AI:
    // routes/ai-actions.ts hardcodes actorType "USER" for those verbs too,
    // and approveAIActionRequest()/executeAIAction() require an
    // authenticated human session regardless of actorType.
    allowedActorTypes: ["AI"],
    requiredEntitlementKey: "grow.activities.manage",
    resourceType: "grow_commitment",
    inputSchema: createGrowCommitmentInput,
    // Reversible in the same sense CREATE_INTERNAL_TASK/CREATE_REMINDER
    // are: the created commitment can be completed or cancelled (existing
    // PATCH /grow/contacts/commitments/:id) but is never hard-deleted as a
    // consequence of this action.
    reversible: true,
    auditRequired: true,
    enabled: true,
    version: 1,
    summarize: (input) =>
      `Create a commitment for contact #${input.partyId}: "${input.description}" (due ${input.dueAt})`,
    execute: async (ctx, input) => {
      const commitment = await createApprovedGrowCommitment({
        brokerageId: ctx.brokerageId,
        createdBy: ctx.userId,
        partyId: input.partyId,
        description: input.description,
        dueAt: input.dueAt,
        propertyId: input.propertyId ?? null,
        opportunityId: input.opportunityId ?? null,
      });
      // Call-review proposals already have a link row from propose time.
      // Stamp the Open commitment onto it. Ask AE proposals have no row;
      // the update matches nothing and does not create a commitment.
      if (ctx.actionRequestId !== undefined) {
        await attachCommitmentToCallReviewLink({
          brokerageId: ctx.brokerageId,
          actionRequestId: ctx.actionRequestId,
          commitmentId: commitment.id,
        });
      }
      return commitment;
    },
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
