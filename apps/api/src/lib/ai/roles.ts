import type { AiContextPackage, AiStructuredResponse } from "./types.js";

// Five-Role AI Capability Architecture (Build Instructions). Each role is a
// typed interface; only Copilot has a real implementation (orchestrator.ts +
// routes/ai.ts). The other four throw "not implemented" - they exist so a
// future build slots into the same gateway/context/tool/audit/entitlement
// pipeline instead of inventing a parallel one under time pressure.
export interface AiRoleHandler {
  ask(ctx: AiContextPackage, question: string): Promise<AiStructuredResponse>;
}

export class NotImplementedRole implements AiRoleHandler {
  private readonly roleName: string;
  constructor(roleName: string) {
    this.roleName = roleName;
  }
  async ask(): Promise<AiStructuredResponse> {
    throw new Error(`AI role "${this.roleName}" is architected but not implemented in this build.`);
  }
}

// Would surface unprompted insights (e.g. "this settlement looks at risk")
// instead of only answering questions the agent asks. Not built.
export class ProactiveIntelligenceRole extends NotImplementedRole {
  constructor() {
    super("proactive_intelligence");
  }
}

// Would give portfolio-level performance coaching. Not built.
export class BusinessCoachRole extends NotImplementedRole {
  constructor() {
    super("business_coach");
  }
}

// Would suggest, and at higher approved risk levels apply, workflow-stage
// transitions. Not built.
export class WorkflowAiRole extends NotImplementedRole {
  constructor() {
    super("workflow_ai");
  }
}

// Would help coordinate Pit Crew service-order workflows. Not built.
export class PitCrewAiRole extends NotImplementedRole {
  constructor() {
    super("pitcrew_ai");
  }
}
