import { logger } from "@aee/events";
import type { AiProvider } from "./provider.js";
import type { AiProviderRequest, AiProviderResponse } from "../types.js";

// Default provider until a real model is approved. Deterministic, offline,
// free — safe to run in this build and in tests. It does not call an LLM.
//
// C-3: callers put the system prompt and a CONTEXT JSON payload on the
// request. Those strings are metering input only (a token estimate from
// their lengths). The user-facing narrative is a fixed placeholder and
// never copies them. Structured coaching figures are built outside this
// provider, by coaching/responseBuilder.ts.
//
// GP-5: the placeholder is an end-user label. The operator instruction
// (which env vars would switch on a real model) stays in the server log.
export const DEMO_AI_USER_TEXT = "Demo AI: sample text, not generated from your data.";

const MOCK_AI_OPERATOR_NOTE =
  "Mock AI is in use. Set AI_PROVIDER=anthropic and ANTHROPIC_API_KEY to use a real model.";

let operatorNoteLogged = false;

export class MockAiProvider implements AiProvider {
  readonly name = "mock";

  async generate(request: AiProviderRequest): Promise<AiProviderResponse> {
    if (!operatorNoteLogged) {
      operatorNoteLogged = true;
      logger.info("mock_ai_provider", { note: MOCK_AI_OPERATOR_NOTE });
    }
    const start = Date.now();
    const text = DEMO_AI_USER_TEXT;
    const promptTokens = Math.ceil((request.systemPrompt.length + request.userPrompt.length) / 4);
    const completionTokens = Math.ceil(text.length / 4);
    return {
      provider: this.name,
      model: "mock-v1",
      text,
      usage: {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
        estimatedCostUsd: 0,
      },
      latencyMs: Date.now() - start,
    };
  }
}
