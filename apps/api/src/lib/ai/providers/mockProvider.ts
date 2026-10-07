import type { AiProvider } from "./provider.js";
import type { AiProviderRequest, AiProviderResponse } from "../types.js";

// Default provider until a real ANTHROPIC_API_KEY is supplied (Replit Secrets),
// matching every other domain's Mock*Provider. Deterministic, offline, free —
// safe to run in this build and in tests. It does not call an LLM.
//
// C-3: callers put the system prompt and a CONTEXT JSON payload on the
// request. Those strings are metering input only (a token estimate from
// their lengths). The user-facing narrative is a fixed placeholder and
// never copies them. Structured coaching figures are built outside this
// provider, by coaching/responseBuilder.ts.
const MOCK_AI_NARRATIVE =
  "This is a Mock AI Provider response. No real model call was made. " +
  "This note does not repeat the question, the prompt, or any retrieved context. " +
  "Where this screen also shows structured figures, those figures come from data already recorded in Agent Engine. " +
  "Set AI_PROVIDER=anthropic and ANTHROPIC_API_KEY in Replit Secrets to use a real model.";

export class MockAiProvider implements AiProvider {
  readonly name = "mock";

  async generate(request: AiProviderRequest): Promise<AiProviderResponse> {
    const start = Date.now();
    const text = MOCK_AI_NARRATIVE;
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
