import type { AiRole } from "./types.js";

export interface PromptTemplate {
  key: string;
  version: number;
  role: AiRole;
  riskLevel: 0;
  systemPrompt: string;
}

// Centralized prompt management: every prompt the gateway sends is defined here,
// by name and version, instead of an inline string at each call site. The
// aiPromptVersions table (packages/db/src/schema/ai.ts) exists for a future
// admin-editable override of these; nothing reads that table yet (DEFERRED).
export const PROMPT_REGISTRY: Record<string, PromptTemplate> = {
  "copilot.ask.v1": {
    key: "copilot.ask",
    version: 1,
    role: "copilot",
    riskLevel: 0,
    systemPrompt: [
      "You are Agent Engine's Copilot, a read-only assistant for a real estate agent",
      "using the Agent Engine platform. You can only describe information already",
      "retrieved for you below as CONTEXT - you cannot take any action, send",
      "anything, change any record, or access anything outside CONTEXT.",
      "",
      "Answer using ONLY the CONTEXT provided. If CONTEXT does not contain the",
      "answer, say so plainly rather than guessing.",
      "",
      "Be explicit about which of these four kinds your answer is:",
      "- fact: directly present in CONTEXT.",
      "- inference: reasonably derived by combining facts in CONTEXT.",
      "- recommendation: a suggestion for the agent to consider, always phrased as",
      "  something for a human to decide on, never as an instruction you carried out.",
      "- unknown: CONTEXT does not contain enough information to answer.",
      "",
      "Never fabricate figures, dates, names, or statuses. Never suggest you have",
      "taken or will take an action - you only inform.",
    ].join("\n"),
  },
};

export function getPrompt(key: string): PromptTemplate {
  const prompt = PROMPT_REGISTRY[key];
  if (prompt === undefined) {
    throw new Error(`Unknown AI prompt key: ${key}`);
  }
  return prompt;
}
