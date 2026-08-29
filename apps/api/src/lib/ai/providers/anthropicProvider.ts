import type { AiProvider } from "./provider.js";
import { AiProviderError } from "../types.js";
import type { AiProviderRequest, AiProviderResponse } from "../types.js";

// Real provider, inactive until AI_PROVIDER=anthropic and ANTHROPIC_API_KEY are
// both set (Replit Secrets - never commit the key). Talks to the Anthropic
// Messages API directly over fetch so this build adds zero new runtime
// dependencies; swap for the official SDK later if richer features are needed.
const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

export class AnthropicAiProvider implements AiProvider {
  readonly name = "anthropic";
  private readonly apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async generate(request: AiProviderRequest): Promise<AiProviderResponse> {
    const start = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), request.timeoutMs);
    try {
      const res = await fetch(ANTHROPIC_API_URL, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
        },
        body: JSON.stringify({
          model: request.model,
          max_tokens: request.maxOutputTokens,
          temperature: request.temperature,
          system: request.systemPrompt,
          messages: [{ role: "user", content: request.userPrompt }],
        }),
      });
      if (res.ok === false) {
        const body = await res.text().catch(() => "");
        throw new AiProviderError("anthropic", `Anthropic API returned ${res.status}: ${body.slice(0, 300)}`);
      }
      const json = (await res.json()) as {
        model: string;
        content: Array<{ type: string; text?: string }>;
        usage: { input_tokens: number; output_tokens: number };
      };
      const text = json.content
        .filter((block) => block.type === "text" && typeof block.text === "string")
        .map((block) => block.text)
        .join("\n")
        .trim();
      const promptTokens = json.usage.input_tokens;
      const completionTokens = json.usage.output_tokens;
      // Pricing varies by model/tier and changes over time; this is a rough
      // Sonnet-class estimate for telemetry purposes only, not a billing figure.
      const estimatedCostUsd = (promptTokens / 1_000_000) * 3 + (completionTokens / 1_000_000) * 15;
      return {
        provider: this.name,
        model: json.model,
        text: text.length > 0 ? text : "(empty response from provider)",
        usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens, estimatedCostUsd },
        latencyMs: Date.now() - start,
      };
    } catch (err) {
      if (err instanceof AiProviderError) throw err;
      const message = err instanceof Error ? err.message : "unknown error";
      throw new AiProviderError("anthropic", `Anthropic provider call failed: ${message}`);
    } finally {
      clearTimeout(timeout);
    }
  }
}
