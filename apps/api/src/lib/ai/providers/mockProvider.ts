import type { AiProvider } from "./provider.js";
import type { AiProviderRequest, AiProviderResponse } from "../types.js";

// Default provider until a real ANTHROPIC_API_KEY is supplied (Replit Secrets),
// matching every other domain's Mock*Provider. Deterministic, offline, free -
// safe to run in this build and in tests. It does not call an LLM: it reflects
// the user prompt back inside a plausible-looking answer so the rest of the
// pipeline (structured response, audit, UI) is fully exercisable end-to-end.
export class MockAiProvider implements AiProvider {
  readonly name = "mock";

  async generate(request: AiProviderRequest): Promise<AiProviderResponse> {
    const start = Date.now();
    const text =
      "Based on the information available to Agent Engine right now: " +
      request.userPrompt.slice(0, 400) +
      "\n\n(This is a Mock AI Provider response - no real model call was made. " +
      "Set AI_PROVIDER=anthropic and ANTHROPIC_API_KEY in Replit Secrets to use a real model.)";
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
