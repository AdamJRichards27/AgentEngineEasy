import type { AiRole } from "./types.js";

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (typeof raw !== "string" || raw.length === 0) return fallback;
  return raw.toLowerCase() === "true";
}

const ROLE_FLAG_ENV: Record<AiRole, string> = {
  copilot: "AI_COPILOT_ENABLED",
  proactive_intelligence: "AI_PROACTIVE_INTELLIGENCE_ENABLED",
  business_coach: "AI_BUSINESS_COACH_ENABLED",
  workflow_ai: "AI_WORKFLOW_AI_ENABLED",
  pitcrew_ai: "AI_PITCREW_AI_ENABLED",
};

export function isAiEnabled(): boolean {
  return envBool("AI_ENABLED", true);
}

// Master switch + a per-role flag, checked server-side on every request in
// orchestrator.ts - never only hidden in the UI. Copilot defaults on; every role
// with no real implementation defaults off so enabling AI_ENABLED alone can never
// expose an unbuilt capability.
export function isRoleEnabled(role: AiRole): boolean {
  if (isAiEnabled() === false) return false;
  return envBool(ROLE_FLAG_ENV[role], role === "copilot");
}

// Optional internal call-transcription drafting uses the same master-switch
// and boolean parsing policy as role flags, without inventing another role.
export function isGrowCallSummaryEnabled(): boolean {
  if (isAiEnabled() === false) return false;
  return envBool("AI_GROW_CALL_SUMMARY_ENABLED", false);
}
