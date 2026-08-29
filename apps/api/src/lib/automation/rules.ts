// Agent Engine 2.0 — Workflow Automation Engine (Stage: Foundation).
//
// Service layer over automationRules / automationRuleVersions — component 1
// ("Workflow definition and versioning model"). Ordinary, non-AI-specific
// domain functions, mirroring the existing workflowProposals.ts precedent
// (propose/activate as plain functions a future admin UI or route would
// call directly — no HTTP route is added in this foundation stage; a
// rule-management UI is explicitly out of scope, see the WF2 report).
//
// Versioning mirrors workflowChangeProposals's proven shape: a rule's
// versions are DRAFT -> PROPOSED -> APPROVED -> ACTIVE -> SUPERSEDED /
// ARCHIVED, at most one ACTIVE version per rule at a time, and activating a
// new version supersedes (never deletes/overwrites) whatever was
// previously ACTIVE — see activateWorkflowChangeProposal in
// workflowProposals.ts, whose supersede-then-activate transaction shape
// this function reproduces for automationRuleVersions.
//
// Two closed-set validations run at write time, in addition to the same
// checks the engine re-verifies at execution time (defense in depth, the
// same convention the AI Governance layer already uses — see
// executionGateway.ts's re-check comment):
//   1. triggerEventType must be a real, canonical AgentEngineEasyEventType.
//   2. every action's actionKey must already be a registered
//      AIActionDefinition in the existing, reused ai/actions/registry.ts —
//      "permit only explicitly registered and validated action types" is
//      enforced here AND again by the engine at execution time, since the
//      registry's contents can change between authoring and execution.

import { and, desc, eq } from "drizzle-orm";
import {
  db,
  automationRules,
  automationRuleVersions,
  users,
  type AutomationRule,
  type AutomationRuleVersion,
} from "@aee/db";
import { AGENT_ENGINE_EASY_EVENT_TYPES, type AgentEngineEasyEventType } from "@aee/events";
import { getActionDefinition } from "../ai/actions/registry.js";
import { automationConditionGroupSchema, type AutomationConditionGroup } from "./conditions.js";

export interface AutomationRuleAction {
  actionKey: string;
  params: unknown;
}

export class AutomationValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AutomationValidationError";
  }
}

function assertValidTriggerEventType(eventType: string): asserts eventType is AgentEngineEasyEventType {
  if (!(AGENT_ENGINE_EASY_EVENT_TYPES as readonly string[]).includes(eventType)) {
    throw new AutomationValidationError(
      `"${eventType}" is not a canonical AgentEngineEasy domain event type. See packages/events/src/types.ts.`,
    );
  }
}

/** Exported for the engine's own defense-in-depth re-check at execution time. */
export function assertActionsAreRegistered(actions: AutomationRuleAction[]): void {
  if (actions.length === 0) {
    throw new AutomationValidationError("A rule version must define at least one action.");
  }
  for (const action of actions) {
    if (!getActionDefinition(action.actionKey)) {
      throw new AutomationValidationError(
        `Action "${action.actionKey}" is not a registered AIActionDefinition (apps/api/src/lib/ai/actions/registry.ts). ` +
          `Automation rules may only reference explicitly registered, validated action types.`,
      );
    }
  }
}

export interface CreateAutomationRuleInput {
  brokerageId: number;
  name: string;
  description?: string | null;
  triggerEventType: string;
  createdByUserId: number;
  isSystemTemplate?: boolean;
  templateKey?: string | null;
}

export async function createAutomationRule(input: CreateAutomationRuleInput): Promise<AutomationRule> {
  assertValidTriggerEventType(input.triggerEventType);
  const [row] = await db
    .insert(automationRules)
    .values({
      brokerageId: input.brokerageId,
      name: input.name,
      description: input.description ?? null,
      triggerEventType: input.triggerEventType,
      status: "DRAFT",
      isSystemTemplate: input.isSystemTemplate ?? false,
      templateKey: input.templateKey ?? null,
      createdByUserId: input.createdByUserId,
    })
    .returning();
  return row;
}

export interface CreateRuleVersionInput {
  ruleId: number;
  brokerageId: number;
  conditionGroup: AutomationConditionGroup;
  actions: AutomationRuleAction[];
  createdByUserId: number | null;
  createdByAi?: boolean;
  changeReason?: string | null;
}

export async function createRuleVersion(input: CreateRuleVersionInput): Promise<AutomationRuleVersion> {
  const [rule] = await db.select().from(automationRules).where(eq(automationRules.id, input.ruleId));
  if (!rule || rule.brokerageId !== input.brokerageId) {
    throw new AutomationValidationError("Automation rule not found in this brokerage.");
  }

  const parsedConditionGroup = automationConditionGroupSchema.parse(input.conditionGroup);
  assertActionsAreRegistered(input.actions);

  const [latest] = await db
    .select({ version: automationRuleVersions.version })
    .from(automationRuleVersions)
    .where(eq(automationRuleVersions.ruleId, input.ruleId))
    .orderBy(desc(automationRuleVersions.version))
    .limit(1);
  const nextVersion = (latest?.version ?? 0) + 1;

  const [row] = await db
    .insert(automationRuleVersions)
    .values({
      ruleId: input.ruleId,
      version: nextVersion,
      status: "DRAFT",
      conditionGroup: parsedConditionGroup,
      actions: input.actions,
      createdByUserId: input.createdByUserId,
      createdByAi: input.createdByAi ?? false,
      changeReason: input.changeReason ?? null,
    })
    .returning();
  return row;
}

export class AutomationApprovalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AutomationApprovalError";
  }
}

/**
 * Moves a rule version DRAFT/PROPOSED -> ACTIVE, superseding whatever
 * version was previously ACTIVE for the same rule, and marks the parent
 * rule ACTIVE (first activation) — same "propose vs activate are different
 * privileges" split Build Instructions Part 9 established for workflow
 * change proposals. Only a Brokerage Administrator of the SAME brokerage
 * may activate — checked here explicitly (there is no HTTP route/role
 * middleware in front of this foundation-stage function to check it for
 * us, unlike WORKFLOW_VERSION_ACTIVATE's route+registry role gate).
 *
 * An AI-authored version (createdByAi) can reach this function, but only
 * ever through an explicit, separate call with a genuine human
 * approvedByUserId — nothing in this module ever calls this automatically
 * on a version's own behalf ("all AI-generated workflow suggestions must
 * enter as drafts and be reviewed before activation").
 */
export async function approveAndActivateRuleVersion(input: {
  versionId: number;
  brokerageId: number;
  approvedByUserId: number;
}): Promise<AutomationRuleVersion> {
  const [version] = await db
    .select()
    .from(automationRuleVersions)
    .where(eq(automationRuleVersions.id, input.versionId));
  if (!version) throw new AutomationApprovalError("Automation rule version not found.");

  const [rule] = await db.select().from(automationRules).where(eq(automationRules.id, version.ruleId));
  if (!rule || rule.brokerageId !== input.brokerageId) {
    throw new AutomationApprovalError("Automation rule version not found in this brokerage.");
  }
  if (version.status !== "DRAFT" && version.status !== "PROPOSED" && version.status !== "APPROVED") {
    throw new AutomationApprovalError(`Cannot activate a rule version in status ${version.status}.`);
  }

  const [approver] = await db.select().from(users).where(eq(users.id, input.approvedByUserId));
  if (!approver || approver.brokerageId !== input.brokerageId) {
    throw new AutomationApprovalError("Approving user not found in this brokerage.");
  }
  if (approver.role !== "Brokerage Administrator") {
    throw new AutomationApprovalError("Only a Brokerage Administrator may activate an automation rule version.");
  }

  await db
    .update(automationRuleVersions)
    .set({ status: "SUPERSEDED", supersededAt: new Date() })
    .where(and(eq(automationRuleVersions.ruleId, version.ruleId), eq(automationRuleVersions.status, "ACTIVE")));

  const [activated] = await db
    .update(automationRuleVersions)
    .set({
      status: "ACTIVE",
      approvedByUserId: input.approvedByUserId,
      approvedAt: new Date(),
      activatedAt: new Date(),
    })
    .where(eq(automationRuleVersions.id, version.id))
    .returning();

  await db.update(automationRules).set({ status: "ACTIVE", updatedAt: new Date() }).where(eq(automationRules.id, rule.id));

  return activated;
}

export async function setAutomationRuleStatus(
  ruleId: number,
  brokerageId: number,
  status: "ACTIVE" | "PAUSED" | "ARCHIVED",
): Promise<AutomationRule> {
  const [rule] = await db.select().from(automationRules).where(eq(automationRules.id, ruleId));
  if (!rule || rule.brokerageId !== brokerageId) {
    throw new AutomationValidationError("Automation rule not found in this brokerage.");
  }
  const [updated] = await db
    .update(automationRules)
    .set({ status, updatedAt: new Date() })
    .where(eq(automationRules.id, ruleId))
    .returning();
  return updated;
}

/**
 * The engine's trigger lookup — component 10 (tenant isolation) is enforced
 * directly in this query's WHERE clause, not as an afterthought filter: a
 * brokerage can only ever see its own ACTIVE rules with an ACTIVE version.
 * A rule whose parent is PAUSED/ARCHIVED is excluded even if it still has
 * an ACTIVE version row (component: "disabled workflow").
 */
export async function getActiveRuleVersionsForTrigger(
  brokerageId: number,
  eventType: string,
): Promise<Array<{ rule: AutomationRule; version: AutomationRuleVersion }>> {
  const rows = await db
    .select({ rule: automationRules, version: automationRuleVersions })
    .from(automationRules)
    .innerJoin(
      automationRuleVersions,
      and(eq(automationRuleVersions.ruleId, automationRules.id), eq(automationRuleVersions.status, "ACTIVE")),
    )
    .where(
      and(
        eq(automationRules.brokerageId, brokerageId),
        eq(automationRules.triggerEventType, eventType),
        eq(automationRules.status, "ACTIVE"),
      ),
    );
  return rows;
}
